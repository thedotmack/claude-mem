#!/usr/bin/env bun
// @bun
import{Database as b}from"bun:sqlite";import{join as W,dirname as T,basename as P}from"path";import{homedir as G}from"os";import{existsSync as k,mkdirSync as x}from"fs";var V=process.env.CLAUDE_MEM_DATA_DIR||W(G(),".claude-mem"),q=process.env.CLAUDE_CONFIG_DIR||W(G(),".claude"),S=W(V,"archives"),l=W(V,"logs"),h=W(V,"trash"),R=W(V,"backups"),A=W(V,"chroma"),j=W(V,"settings.json"),L=W(V,"claude-mem.db"),_=W(q,"settings.json"),I=W(q,"commands"),y=W(q,"CLAUDE.md");function N(z){x(z,{recursive:!0})}class v{db;constructor(){N(V),this.db=new b(L,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,Y=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,Y)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,Y,Q){let K=new Date,$=K.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,Y,Q,K.toISOString(),$),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,Y){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Y,z)}storeObservation(z,Y,Q,K){let $=new Date,X=$.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,Y,K,Q,$.toISOString(),X)}storeSummary(z,Y,Q){let K=new Date,$=K.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,Y,Q.request||null,Q.investigated||null,Q.learned||null,Q.completed||null,Q.next_steps||null,Q.files_read||null,Q.files_edited||null,Q.notes||null,K.toISOString(),$)}markSessionCompleted(z){let Y=new Date,Q=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),Q,z)}markSessionFailed(z){let Y=new Date,Q=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),Q,z)}close(){this.db.close()}}import U from"path";function H(z){try{if(console.error("[claude-mem context] Hook fired with input:",JSON.stringify({session_id:z?.session_id,transcript_path:z?.transcript_path,hook_event_name:z?.hook_event_name,source:z?.source,has_input:!!z})),!z)console.error("[claude-mem context] No input provided - exiting (standalone mode)"),console.log("No input provided - this script is designed to run as a Claude Code SessionStart hook"),process.exit(0);let Y=U.dirname(z.transcript_path),Q=U.basename(Y);console.error("[claude-mem context] Extracted project name:",Q,"from transcript_path:",z.transcript_path),console.error("[claude-mem context] Querying database for recent summaries...");let K=new v,$=K.getRecentSummaries(Q,5);if(K.close(),console.error("[claude-mem context] Database query complete - found",$.length,"summaries"),$.length>0)console.error("[claude-mem context] Summary previews:"),$.forEach((Z,B)=>{let F=Z.request?.substring(0,100)||Z.completed?.substring(0,100)||"(no content)";console.error(`  [${B+1}]`,F+(F.length>=100?"...":""))});if($.length===0)console.error("[claude-mem context] No summaries found - outputting empty context message"),console.log(`# Recent Session Context

No previous sessions found for this project yet.`),process.exit(0);console.error("[claude-mem context] Building markdown context from summaries...");let X=[];X.push("# Recent Session Context"),X.push("");let M=$.length===1?"session":"sessions";X.push(`Showing last ${$.length} ${M} for **${Q}**:`),X.push("");for(let Z of $){if(X.push("---"),X.push(""),Z.request)X.push(`**Request:** ${Z.request}`);if(Z.completed)X.push(`**Completed:** ${Z.completed}`);if(Z.learned)X.push(`**Learned:** ${Z.learned}`);if(Z.next_steps)X.push(`**Next Steps:** ${Z.next_steps}`);if(Z.files_read)try{let B=JSON.parse(Z.files_read);if(Array.isArray(B)&&B.length>0)X.push(`**Files Read:** ${B.join(", ")}`)}catch{if(Z.files_read.trim())X.push(`**Files Read:** ${Z.files_read}`)}if(Z.files_edited)try{let B=JSON.parse(Z.files_edited);if(Array.isArray(B)&&B.length>0)X.push(`**Files Edited:** ${B.join(", ")}`)}catch{if(Z.files_edited.trim())X.push(`**Files Edited:** ${Z.files_edited}`)}X.push(`**Date:** ${Z.created_at.split("T")[0]}`),X.push("")}let J=X.join(`
`);console.error("[claude-mem context] Markdown built successfully"),console.error("[claude-mem context] Output length:",J.length,"characters,",X.length,"lines"),console.error("[claude-mem context] Output preview (first 200 chars):",J.substring(0,200)+"..."),console.error("[claude-mem context] Outputting context to stdout for Claude Code injection"),console.log(J),console.error("[claude-mem context] Context hook completed successfully"),process.exit(0)}catch(Y){console.error("[claude-mem context] ERROR occurred during context hook execution"),console.error("[claude-mem context] Error message:",Y.message),console.error("[claude-mem context] Error stack:",Y.stack),console.error("[claude-mem context] Exiting gracefully to avoid blocking Claude Code"),process.exit(0)}}var O=await Bun.stdin.text();try{let z=O.trim()?JSON.parse(O):void 0;H(z)}catch(z){console.error(`[claude-mem context-hook error: ${z.message}]`),process.exit(0)}
