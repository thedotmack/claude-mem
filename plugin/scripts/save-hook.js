#!/usr/bin/env node
import h from"better-sqlite3";import{join as a,dirname as N,basename as v}from"path";import{homedir as g}from"os";import{existsSync as P,mkdirSync as f}from"fs";var u=process.env.CLAUDE_MEM_DATA_DIR||a(g(),".claude-mem"),_=process.env.CLAUDE_CONFIG_DIR||a(g(),".claude"),w=a(u,"archives"),y=a(u,"logs"),U=a(u,"trash"),H=a(u,"backups"),M=a(u,"settings.json"),b=a(u,"claude-mem.db"),W=a(_,"settings.json"),j=a(_,"commands"),F=a(_,"CLAUDE.md");function T(o){f(o,{recursive:!0})}var l=class{db;constructor(){T(u),this.db=new h(b),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(p=>p.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table"));let m=this.db.pragma("index_list(session_summaries)").some(p=>p.unique===1)}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(t=>t.unique===1))return;console.error("[HooksDatabase] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,s,t,r,n){let i=new Date,c=i.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r,t,n||null,i.toISOString(),c)}storeSummary(e,s,t,r){let n=new Date,i=n.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request||null,t.investigated||null,t.learned||null,t.completed||null,t.next_steps||null,t.files_read||null,t.files_edited||null,t.notes||null,r||null,n.toISOString(),i)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};function R(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function d(o,e,s={}){let t=R(o,e,s);return JSON.stringify(t)}var D=new Set(["TodoWrite","ListMcpResourcesTool"]);async function k(o){if(!o)throw new Error("saveHook requires input");let{session_id:e,tool_name:s,tool_input:t,tool_output:r}=o;if(D.has(s)){console.log(d("PostToolUse",!0));return}let n=new l,i=n.findActiveSDKSession(e);if(!i){n.close(),console.log(d("PostToolUse",!0));return}if(!i.worker_port){n.close(),console.error("[save-hook] No worker port for session",i.id),console.log(d("PostToolUse",!0));return}let c=n.getPromptCounter(i.id);n.close();try{let m=await fetch(`http://127.0.0.1:${i.worker_port}/sessions/${i.id}/observations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:s,tool_input:JSON.stringify(t),tool_output:JSON.stringify(r),prompt_number:c}),signal:AbortSignal.timeout(2e3)});m.ok||console.error("[save-hook] Failed to send observation:",await m.text())}catch(m){console.error("[save-hook] Error:",m.message)}finally{console.log(d("PostToolUse",!0))}}import{stdin as S}from"process";var E="";S.on("data",o=>E+=o);S.on("end",async()=>{try{let o=E.trim()?JSON.parse(E):void 0;await k(o)}catch(o){console.error(`[claude-mem save-hook error: ${o.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
