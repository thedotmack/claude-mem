#!/usr/bin/env node
import R from"path";import D from"better-sqlite3";import{join as c,dirname as w,basename as v}from"path";import{homedir as f}from"os";import{existsSync as C,mkdirSync as k}from"fs";var l=process.env.CLAUDE_MEM_DATA_DIR||c(f(),".claude-mem"),g=process.env.CLAUDE_CONFIG_DIR||c(f(),".claude"),L=c(l,"archives"),P=c(l,"logs"),N=c(l,"trash"),j=c(l,"backups"),H=c(l,"settings.json"),E=c(l,"claude-mem.db"),U=c(g,"settings.json"),W=c(g,"commands"),$=c(g,"CLAUDE.md");function S(p){k(p,{recursive:!0})}var u=class{db;constructor(){S(l),this.db=new D(E),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).run(t,e)}createSDKSession(e,t,s){let o=new Date,i=o.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,o.toISOString(),i).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,t,s,o){let i=new Date,r=i.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,t,o,s,i.toISOString(),r)}storeSummary(e,t,s){let o=new Date,i=o.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request||null,s.investigated||null,s.learned||null,s.completed||null,s.next_steps||null,s.files_read||null,s.files_edited||null,s.notes||null,o.toISOString(),i)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function _(p){let e=p?.cwd??process.cwd(),t=e?R.basename(e):"unknown-project",s=new u;try{let o=s.getRecentSummaries(t,5),i=s.getRecentObservations(t,20);if(o.length===0&&i.length===0){console.log(`# Recent Session Context

No previous sessions found for this project yet.`);return}let r=[];if(r.push("# Recent Session Context"),r.push(""),i.length>0){r.push(`## Recent Observations (${i.length})`),r.push("");let n={};for(let a of i)n[a.type]||(n[a.type]=[]),n[a.type].push({text:a.text,created_at:a.created_at});let d=["feature","bugfix","refactor","discovery","decision"];for(let a of d)if(n[a]&&n[a].length>0){r.push(`### ${a.charAt(0).toUpperCase()+a.slice(1)}s`);for(let b of n[a])r.push(`- ${b.text}`);r.push("")}}if(o.length===0){console.log(r.join(`
`));return}r.push("## Recent Sessions"),r.push("");let m=o.length===1?"session":"sessions";r.push(`Showing last ${o.length} ${m} for **${t}**:`),r.push("");for(let n of o){if(r.push("---"),r.push(""),n.request&&r.push(`**Request:** ${n.request}`),n.completed&&r.push(`**Completed:** ${n.completed}`),n.learned&&r.push(`**Learned:** ${n.learned}`),n.next_steps&&r.push(`**Next Steps:** ${n.next_steps}`),n.files_read)try{let d=JSON.parse(n.files_read);Array.isArray(d)&&d.length>0&&r.push(`**Files Read:** ${d.join(", ")}`)}catch{n.files_read.trim()&&r.push(`**Files Read:** ${n.files_read}`)}if(n.files_edited)try{let d=JSON.parse(n.files_edited);Array.isArray(d)&&d.length>0&&r.push(`**Files Edited:** ${d.join(", ")}`)}catch{n.files_edited.trim()&&r.push(`**Files Edited:** ${n.files_edited}`)}r.push(`**Date:** ${n.created_at.split("T")[0]}`),r.push("")}console.log(r.join(`
`))}finally{s.close()}}import{stdin as h}from"process";try{if(h.isTTY)_();else{let p="";h.on("data",e=>p+=e),h.on("end",()=>{let e=p.trim()?JSON.parse(p):void 0;_(e)})}}catch(p){console.error(`[claude-mem context-hook error: ${p.message}]`),process.exit(0)}
