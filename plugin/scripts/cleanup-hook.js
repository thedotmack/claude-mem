#!/usr/bin/env node
import h from"better-sqlite3";import{join as i,dirname as T,basename as w}from"path";import{homedir as u}from"os";import{existsSync as x,mkdirSync as S}from"fs";var a=process.env.CLAUDE_MEM_DATA_DIR||i(u(),".claude-mem"),l=process.env.CLAUDE_CONFIG_DIR||i(u(),".claude"),I=i(a,"archives"),O=i(a,"logs"),L=i(a,"trash"),y=i(a,"backups"),C=i(a,"settings.json"),m=i(a,"claude-mem.db"),P=i(l,"settings.json"),H=i(l,"commands"),N=i(l,"CLAUDE.md");function _(o){S(o,{recursive:!0})}var c=class{db;constructor(){_(a),this.db=new h(m),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentObservations(e,s=20){return this.db.prepare(`
      SELECT type, text, created_at
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
    `).run(s,e)}createSDKSession(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}updateSDKSessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(s,e)}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,s,t,r){let n=new Date,d=n.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,s,r,t,n.toISOString(),d)}storeSummary(e,s,t){let r=new Date,n=r.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request||null,t.investigated||null,t.learned||null,t.completed||null,t.next_steps||null,t.files_read||null,t.files_edited||null,t.notes||null,r.toISOString(),n)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};async function g(o){try{console.error("[claude-mem cleanup] Hook fired",{input:o?{session_id:o.session_id,cwd:o.cwd,reason:o.reason}:null}),o||(console.log("No input provided - this script is designed to run as a Claude Code SessionEnd hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string",transcript_path:"string",hook_event_name:"SessionEnd",reason:"exit"},null,2)),process.exit(0));let{session_id:e,reason:s}=o;console.error("[claude-mem cleanup] Searching for active SDK session",{session_id:e,reason:s});let t=new c,r=t.findActiveSDKSession(e);if(r||(console.error("[claude-mem cleanup] No active SDK session found",{session_id:e}),t.close(),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)),console.error("[claude-mem cleanup] Active SDK session found",{session_id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,worker_port:r.worker_port}),r.worker_port)try{let n=await fetch(`http://127.0.0.1:${r.worker_port}/sessions/${r.id}`,{method:"DELETE",signal:AbortSignal.timeout(5e3)});n.ok?console.error("[claude-mem cleanup] Session deleted successfully via HTTP"):console.error("[claude-mem cleanup] Failed to delete session:",await n.text())}catch(n){console.error("[claude-mem cleanup] HTTP DELETE error:",n.message)}else console.error("[claude-mem cleanup] No worker port, cannot send DELETE request");try{t.markSessionFailed(r.id),console.error("[claude-mem cleanup] Session marked as failed in database")}catch(n){console.error("[claude-mem cleanup] Failed to mark session as failed:",n)}t.close(),console.error("[claude-mem cleanup] Cleanup completed successfully"),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}catch(e){console.error("[claude-mem cleanup] Unexpected error in hook",{error:e.message,stack:e.stack,name:e.name}),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}import{stdin as E}from"process";var p="";E.on("data",o=>p+=o);E.on("end",async()=>{try{let o=p.trim()?JSON.parse(p):void 0;await g(o)}catch(o){console.error(`[claude-mem cleanup-hook error: ${o.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
