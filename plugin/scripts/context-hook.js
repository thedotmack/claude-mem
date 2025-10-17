#!/usr/bin/env node
import D from"path";import R from"better-sqlite3";import{join as m,dirname as N,basename as v}from"path";import{homedir as h}from"os";import{existsSync as O,mkdirSync as S}from"fs";var d=process.env.CLAUDE_MEM_DATA_DIR||m(h(),".claude-mem"),E=process.env.CLAUDE_CONFIG_DIR||m(h(),".claude"),w=m(d,"archives"),U=m(d,"logs"),P=m(d,"trash"),H=m(d,"backups"),M=m(d,"settings.json"),T=m(d,"claude-mem.db"),j=m(E,"settings.json"),$=m(E,"commands"),W=m(E,"CLAUDE.md");function f(p){S(p,{recursive:!0})}var l=class{db;constructor(){f(d),this.db=new R(T),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(c=>c.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table"));let n=this.db.pragma("index_list(session_summaries)").some(c=>c.unique===1)}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(t=>t.unique===1))return;console.error("[HooksDatabase] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let i=new Date,a=i.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,s,t,i.toISOString(),a).lastInsertRowid}updateSDKSessionId(e,s){this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,s,t,i,a){let r=new Date,u=r.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,i,t,a||null,r.toISOString(),u)}storeSummary(e,s,t,i){let a=new Date,r=a.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request||null,t.investigated||null,t.learned||null,t.completed||null,t.next_steps||null,t.files_read||null,t.files_edited||null,t.notes||null,i||null,a.toISOString(),r)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};function g(p){let e=p?.cwd??process.cwd(),s=e?D.basename(e):"unknown-project",t=new l;try{let i=t.getRecentSummaries(s,5),a=t.getRecentObservations(s,20);if(i.length===0&&a.length===0){console.log(`# Recent Session Context

No previous sessions found for this project yet.`);return}let r=[];if(r.push("# Recent Session Context"),r.push(""),a.length>0){r.push(`## Recent Observations (${a.length})`),r.push("");let n={};for(let o of a)n[o.type]||(n[o.type]=[]),n[o.type].push({text:o.text,prompt_number:o.prompt_number,created_at:o.created_at});let c=["feature","bugfix","refactor","discovery","decision"];for(let o of c)if(n[o]&&n[o].length>0){r.push(`### ${o.charAt(0).toUpperCase()+o.slice(1)}s`);for(let _ of n[o]){let k=_.prompt_number?` (prompt #${_.prompt_number})`:"";r.push(`- ${_.text}${k}`)}r.push("")}}if(i.length===0){console.log(r.join(`
`));return}r.push("## Recent Sessions"),r.push("");let u=i.length===1?"session":"sessions";r.push(`Showing last ${i.length} ${u} for **${s}**:`),r.push("");for(let n of i){r.push("---"),r.push("");let c=n.prompt_number?` (Prompt #${n.prompt_number})`:"";if(r.push(`**Summary${c}**`),r.push(""),n.request&&r.push(`**Request:** ${n.request}`),n.completed&&r.push(`**Completed:** ${n.completed}`),n.learned&&r.push(`**Learned:** ${n.learned}`),n.next_steps&&r.push(`**Next Steps:** ${n.next_steps}`),n.files_read)try{let o=JSON.parse(n.files_read);Array.isArray(o)&&o.length>0&&r.push(`**Files Read:** ${o.join(", ")}`)}catch{n.files_read.trim()&&r.push(`**Files Read:** ${n.files_read}`)}if(n.files_edited)try{let o=JSON.parse(n.files_edited);Array.isArray(o)&&o.length>0&&r.push(`**Files Edited:** ${o.join(", ")}`)}catch{n.files_edited.trim()&&r.push(`**Files Edited:** ${n.files_edited}`)}r.push(`**Date:** ${n.created_at.split("T")[0]}`),r.push("")}console.log(r.join(`
`))}finally{t.close()}}import{stdin as b}from"process";try{if(b.isTTY)g();else{let p="";b.on("data",e=>p+=e),b.on("end",()=>{let e=p.trim()?JSON.parse(p):void 0;g(e)})}}catch(p){console.error(`[claude-mem context-hook error: ${p.message}]`),process.exit(0)}
