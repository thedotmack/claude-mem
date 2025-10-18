#!/usr/bin/env node
import S from"path";import k from"better-sqlite3";import{join as m,dirname as N,basename as y}from"path";import{homedir as T}from"os";import{existsSync as C,mkdirSync as D}from"fs";var d=process.env.CLAUDE_MEM_DATA_DIR||m(T(),".claude-mem"),E=process.env.CLAUDE_CONFIG_DIR||m(T(),".claude"),w=m(d,"archives"),U=m(d,"logs"),H=m(d,"trash"),P=m(d,"backups"),M=m(d,"settings.json"),h=m(d,"claude-mem.db"),j=m(E,"settings.json"),F=m(E,"commands"),W=m(E,"CLAUDE.md");function f(p){D(p,{recursive:!0})}var l=class{db;constructor(){f(d),this.db=new k(h),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(c=>c.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table"));let o=this.db.pragma("index_list(session_summaries)").some(c=>c.unique===1)}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(s=>s.unique===1))return;console.error("[HooksDatabase] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),console.error("[HooksDatabase] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(s){throw this.db.exec("ROLLBACK"),s}}catch(e){console.error("[HooksDatabase] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.pragma("table_info(observations)").some(s=>s.name==="title"))return;console.error("[HooksDatabase] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),console.error("[HooksDatabase] Successfully added hierarchical fields to observations table")}catch(e){console.error("[HooksDatabase] Migration error (add hierarchical fields):",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).all(e,t)}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,s){let i=new Date,a=i.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,i.toISOString(),a).lastInsertRowid}updateSDKSessionId(e,t){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(t,e).changes===0?(console.error(`[HooksDatabase] Skipped updating sdk_session_id for session ${e} - already set (prevents FOREIGN KEY constraint violation)`),!1):!0}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,t,s,i){let a=new Date,r=a.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),i||null,a.toISOString(),r)}storeSummary(e,t,s,i){let a=new Date,r=a.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,i||null,a.toISOString(),r)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function b(p){let e=p?.cwd??process.cwd(),t=e?S.basename(e):"unknown-project",s=new l;try{let i=s.getRecentSummaries(t,5),a=s.getRecentObservations(t,20);if(i.length===0&&a.length===0){console.log(`# Recent Session Context

No previous sessions found for this project yet.`);return}let r=[];if(r.push("# Recent Session Context"),r.push(""),a.length>0){r.push(`## Recent Observations (${a.length})`),r.push("");let o={};for(let n of a)o[n.type]||(o[n.type]=[]),o[n.type].push({text:n.text,prompt_number:n.prompt_number,created_at:n.created_at});let c=["feature","bugfix","refactor","discovery","decision"];for(let n of c)if(o[n]&&o[n].length>0){r.push(`### ${n.charAt(0).toUpperCase()+n.slice(1)}s`);for(let _ of o[n]){let A=_.prompt_number?` (prompt #${_.prompt_number})`:"";r.push(`- ${_.text}${A}`)}r.push("")}}if(i.length===0){console.log(r.join(`
`));return}r.push("## Recent Sessions"),r.push("");let u=i.length===1?"session":"sessions";r.push(`Showing last ${i.length} ${u} for **${t}**:`),r.push("");for(let o of i){r.push("---"),r.push("");let c=o.prompt_number?` (Prompt #${o.prompt_number})`:"";if(r.push(`**Summary${c}**`),r.push(""),o.request&&r.push(`**Request:** ${o.request}`),o.completed&&r.push(`**Completed:** ${o.completed}`),o.learned&&r.push(`**Learned:** ${o.learned}`),o.next_steps&&r.push(`**Next Steps:** ${o.next_steps}`),o.files_read)try{let n=JSON.parse(o.files_read);Array.isArray(n)&&n.length>0&&r.push(`**Files Read:** ${n.join(", ")}`)}catch{o.files_read.trim()&&r.push(`**Files Read:** ${o.files_read}`)}if(o.files_edited)try{let n=JSON.parse(o.files_edited);Array.isArray(n)&&n.length>0&&r.push(`**Files Edited:** ${n.join(", ")}`)}catch{o.files_edited.trim()&&r.push(`**Files Edited:** ${o.files_edited}`)}r.push(`**Date:** ${o.created_at.split("T")[0]}`),r.push("")}console.log(r.join(`
`))}finally{s.close()}}import{stdin as g}from"process";try{if(g.isTTY)b();else{let p="";g.on("data",e=>p+=e),g.on("end",()=>{let e=p.trim()?JSON.parse(p):void 0;b(e),process.exit(0)})}}catch(p){console.error(`[claude-mem context-hook error: ${p.message}]`),process.exit(0)}
