#!/usr/bin/env bun
// @bun
import{Database as O}from"bun:sqlite";import{join as K,dirname as E,basename as T}from"path";import{homedir as F}from"os";import{existsSync as w,mkdirSync as H}from"fs";var B=process.env.CLAUDE_MEM_DATA_DIR||K(F(),".claude-mem"),M=process.env.CLAUDE_CONFIG_DIR||K(F(),".claude"),k=K(B,"archives"),S=K(B,"logs"),h=K(B,"trash"),l=K(B,"backups"),R=K(B,"chroma"),A=K(B,"settings.json"),G=K(B,"claude-mem.db"),j=K(M,"settings.json"),_=K(M,"commands"),I=K(M,"CLAUDE.md");function L(z){H(z,{recursive:!0})}class q{db;constructor(){L(B),this.db=new O(G,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,X=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,X)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,X,Y){let $=new Date,Q=$.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,X,Y,$.toISOString(),Q),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,X){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(X,z)}storeObservation(z,X,Y,$){let Q=new Date,V=Q.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,X,$,Y,Q.toISOString(),V)}storeSummary(z,X,Y){let $=new Date,Q=$.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,X,Y.request||null,Y.investigated||null,Y.learned||null,Y.completed||null,Y.next_steps||null,Y.files_read||null,Y.files_edited||null,Y.notes||null,$.toISOString(),Q)}markSessionCompleted(z){let X=new Date,Y=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Y,z)}markSessionFailed(z){let X=new Date,Y=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Y,z)}close(){this.db.close()}}import x from"path";function N(z){try{if(console.error("[claude-mem context] Hook fired with input:",JSON.stringify({session_id:z?.session_id,cwd:z?.cwd,source:z?.source,has_input:!!z})),!z)console.error("[claude-mem context] No input provided - exiting (standalone mode)"),console.log("No input provided - this script is designed to run as a Claude Code SessionStart hook"),process.exit(0);let X=x.basename(z.cwd);console.error("[claude-mem context] Extracted project name:",X,"from cwd:",z.cwd),console.error("[claude-mem context] Querying database for recent summaries...");let Y=new q,$=Y.getRecentSummaries(X,5);if(Y.close(),console.error("[claude-mem context] Database query complete - found",$.length,"summaries"),$.length>0)console.error("[claude-mem context] Summary previews:"),$.forEach((Z,W)=>{let v=Z.request?.substring(0,100)||Z.completed?.substring(0,100)||"(no content)";console.error(`  [${W+1}]`,v+(v.length>=100?"...":""))});if($.length===0)console.error("[claude-mem context] No summaries found - outputting empty context message"),console.log(`# Recent Session Context

No previous sessions found for this project yet.`),process.exit(0);console.error("[claude-mem context] Building markdown context from summaries...");let Q=[];Q.push("# Recent Session Context"),Q.push("");let V=$.length===1?"session":"sessions";Q.push(`Showing last ${$.length} ${V} for **${X}**:`),Q.push("");for(let Z of $){if(Q.push("---"),Q.push(""),Z.request)Q.push(`**Request:** ${Z.request}`);if(Z.completed)Q.push(`**Completed:** ${Z.completed}`);if(Z.learned)Q.push(`**Learned:** ${Z.learned}`);if(Z.next_steps)Q.push(`**Next Steps:** ${Z.next_steps}`);if(Z.files_read)try{let W=JSON.parse(Z.files_read);if(Array.isArray(W)&&W.length>0)Q.push(`**Files Read:** ${W.join(", ")}`)}catch{if(Z.files_read.trim())Q.push(`**Files Read:** ${Z.files_read}`)}if(Z.files_edited)try{let W=JSON.parse(Z.files_edited);if(Array.isArray(W)&&W.length>0)Q.push(`**Files Edited:** ${W.join(", ")}`)}catch{if(Z.files_edited.trim())Q.push(`**Files Edited:** ${Z.files_edited}`)}Q.push(`**Date:** ${Z.created_at.split("T")[0]}`),Q.push("")}let J=Q.join(`
`);console.error("[claude-mem context] Markdown built successfully"),console.error("[claude-mem context] Output length:",J.length,"characters,",Q.length,"lines"),console.error("[claude-mem context] Output preview (first 200 chars):",J.substring(0,200)+"..."),console.error("[claude-mem context] Outputting context to stdout for Claude Code injection"),console.log(J),console.error("[claude-mem context] Context hook completed successfully"),process.exit(0)}catch(X){console.error("[claude-mem context] ERROR occurred during context hook execution"),console.error("[claude-mem context] Error message:",X.message),console.error("[claude-mem context] Error stack:",X.stack),console.error("[claude-mem context] Exiting gracefully to avoid blocking Claude Code"),process.exit(0)}}var U=await Bun.stdin.text();try{let z=U.trim()?JSON.parse(U):void 0;N(z)}catch(z){console.error(`[claude-mem context-hook error: ${z.message}]`),process.exit(0)}
