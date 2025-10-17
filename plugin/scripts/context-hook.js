#!/usr/bin/env node
import R from"path";import T from"better-sqlite3";import{join as c,dirname as x,basename as y}from"path";import{homedir as E}from"os";import{existsSync as O,mkdirSync as D}from"fs";var u=process.env.CLAUDE_MEM_DATA_DIR||c(E(),".claude-mem"),g=process.env.CLAUDE_CONFIG_DIR||c(E(),".claude"),P=c(u,"archives"),N=c(u,"logs"),H=c(u,"trash"),U=c(u,"backups"),M=c(u,"settings.json"),f=c(u,"claude-mem.db"),W=c(g,"settings.json"),$=c(g,"commands"),j=c(g,"CLAUDE.md");function k(m){D(m,{recursive:!0})}var l=class{db;constructor(){k(u),this.db=new T(f),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(p=>p.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table")),this.db.pragma("index_list(session_summaries)").some(p=>p.unique===1)&&(console.error("[HooksDatabase] WARNING: session_summaries.sdk_session_id has UNIQUE constraint. Cannot be removed in SQLite without recreating table."),console.error("[HooksDatabase] Multiple summaries per session will fail until table is recreated."))}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,r){let i=new Date,a=i.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,r,i.toISOString(),a).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,t,r,i,a){let s=new Date,d=s.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,i,r,a||null,s.toISOString(),d)}storeSummary(e,t,r,i){let a=new Date,s=a.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,r.request||null,r.investigated||null,r.learned||null,r.completed||null,r.next_steps||null,r.files_read||null,r.files_edited||null,r.notes||null,i||null,a.toISOString(),s)}markSessionCompleted(e){let t=new Date,r=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),r,e)}markSessionFailed(e){let t=new Date,r=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),r,e)}cleanupOrphanedSessions(){let e=new Date,t=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function b(m){let e=m?.cwd??process.cwd(),t=e?R.basename(e):"unknown-project",r=new l;try{let i=r.getRecentSummaries(t,5),a=r.getRecentObservations(t,20);if(i.length===0&&a.length===0){console.log(`# Recent Session Context

No previous sessions found for this project yet.`);return}let s=[];if(s.push("# Recent Session Context"),s.push(""),a.length>0){s.push(`## Recent Observations (${a.length})`),s.push("");let n={};for(let o of a)n[o.type]||(n[o.type]=[]),n[o.type].push({text:o.text,prompt_number:o.prompt_number,created_at:o.created_at});let p=["feature","bugfix","refactor","discovery","decision"];for(let o of p)if(n[o]&&n[o].length>0){s.push(`### ${o.charAt(0).toUpperCase()+o.slice(1)}s`);for(let _ of n[o]){let S=_.prompt_number?` (prompt #${_.prompt_number})`:"";s.push(`- ${_.text}${S}`)}s.push("")}}if(i.length===0){console.log(s.join(`
`));return}s.push("## Recent Sessions"),s.push("");let d=i.length===1?"session":"sessions";s.push(`Showing last ${i.length} ${d} for **${t}**:`),s.push("");for(let n of i){s.push("---"),s.push("");let p=n.prompt_number?` (Prompt #${n.prompt_number})`:"";if(s.push(`**Summary${p}**`),s.push(""),n.request&&s.push(`**Request:** ${n.request}`),n.completed&&s.push(`**Completed:** ${n.completed}`),n.learned&&s.push(`**Learned:** ${n.learned}`),n.next_steps&&s.push(`**Next Steps:** ${n.next_steps}`),n.files_read)try{let o=JSON.parse(n.files_read);Array.isArray(o)&&o.length>0&&s.push(`**Files Read:** ${o.join(", ")}`)}catch{n.files_read.trim()&&s.push(`**Files Read:** ${n.files_read}`)}if(n.files_edited)try{let o=JSON.parse(n.files_edited);Array.isArray(o)&&o.length>0&&s.push(`**Files Edited:** ${o.join(", ")}`)}catch{n.files_edited.trim()&&s.push(`**Files Edited:** ${n.files_edited}`)}s.push(`**Date:** ${n.created_at.split("T")[0]}`),s.push("")}console.log(s.join(`
`))}finally{r.close()}}import{stdin as h}from"process";try{if(h.isTTY)b();else{let m="";h.on("data",e=>m+=e),h.on("end",()=>{let e=m.trim()?JSON.parse(m):void 0;b(e)})}}catch(m){console.error(`[claude-mem context-hook error: ${m.message}]`),process.exit(0)}
