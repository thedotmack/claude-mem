#!/usr/bin/env bun
// @bun
import{Database as N}from"bun:sqlite";import{join as $,dirname as b,basename as f}from"path";import{homedir as J}from"os";import{existsSync as P,mkdirSync as L}from"fs";var K=process.env.CLAUDE_MEM_DATA_DIR||$(J(),".claude-mem"),V=process.env.CLAUDE_CONFIG_DIR||$(J(),".claude"),w=$(K,"archives"),C=$(K,"logs"),k=$(K,"trash"),l=$(K,"backups"),S=$(K,"chroma"),h=$(K,"settings.json"),M=$(K,"claude-mem.db"),R=$(V,"settings.json"),A=$(V,"commands"),j=$(V,"CLAUDE.md");function q(z){L(z,{recursive:!0})}class v{db;constructor(){q(K),this.db=new N(M,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,W=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,W)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,W,X){let Z=new Date,Q=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,W,X,Z.toISOString(),Q),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,W){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(W,z)}storeObservation(z,W,X,Z){let Q=new Date,Y=Q.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,W,Z,X,Q.toISOString(),Y)}storeSummary(z,W,X){let Z=new Date,Q=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,W,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,Z.toISOString(),Q)}markSessionCompleted(z){let W=new Date,X=W.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(W.toISOString(),X,z)}markSessionFailed(z){let W=new Date,X=W.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(W.toISOString(),X,z)}close(){this.db.close()}}import O from"path";function F(z){try{if(!z)console.log("No input provided - this script is designed to run as a Claude Code SessionStart hook"),process.exit(0);if(z.source&&z.source!=="startup")console.log(""),process.exit(0);let W=O.basename(z.cwd),X=new v,Z=X.getRecentSummaries(W,5);if(X.close(),Z.length===0)console.log(`# Recent Session Context

No previous sessions found for this project yet.`),process.exit(0);let Q=[];Q.push("# Recent Session Context"),Q.push(""),Q.push(`Here's what happened in recent ${W} sessions:`),Q.push("");for(let Y of Z){if(Q.push("---"),Q.push(""),Y.request)Q.push(`**Request:** ${Y.request}`);if(Y.completed)Q.push(`**Completed:** ${Y.completed}`);if(Y.learned)Q.push(`**Learned:** ${Y.learned}`);if(Y.next_steps)Q.push(`**Next Steps:** ${Y.next_steps}`);if(Y.files_edited)try{let B=JSON.parse(Y.files_edited);if(Array.isArray(B)&&B.length>0)Q.push(`**Files Edited:** ${B.join(", ")}`)}catch{if(Y.files_edited.trim())Q.push(`**Files Edited:** ${Y.files_edited}`)}Q.push(`**Date:** ${Y.created_at.split("T")[0]}`),Q.push("")}console.log(Q.join(`
`)),process.exit(0)}catch(W){console.error(`[claude-mem context error: ${W.message}]`),process.exit(0)}}var G=await Bun.stdin.text();try{let z=G.trim()?JSON.parse(G):void 0;F(z)}catch(z){console.error(`[claude-mem context-hook error: ${z.message}]`),process.exit(0)}
