#!/usr/bin/env bun
// @bun
import U from"path";import{Database as O}from"bun:sqlite";import{join as K,dirname as b,basename as g}from"path";import{homedir as F}from"os";import{existsSync as P,mkdirSync as N}from"fs";var B=process.env.CLAUDE_MEM_DATA_DIR||K(F(),".claude-mem"),J=process.env.CLAUDE_CONFIG_DIR||K(F(),".claude"),C=K(B,"archives"),w=K(B,"logs"),k=K(B,"trash"),S=K(B,"backups"),h=K(B,"chroma"),l=K(B,"settings.json"),G=K(B,"claude-mem.db"),R=K(J,"settings.json"),A=K(J,"commands"),j=K(J,"CLAUDE.md");function L(z){N(z,{recursive:!0})}class M{db;constructor(){L(B),this.db=new O(G,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,Q=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,Q)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,Q,X){let $=new Date,W=$.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,Q,X,$.toISOString(),W),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,Q){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Q,z)}storeObservation(z,Q,X,$){let W=new Date,Y=W.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,Q,$,X,W.toISOString(),Y)}storeSummary(z,Q,X){let $=new Date,W=$.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,Q,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,$.toISOString(),W)}markSessionCompleted(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}markSessionFailed(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}close(){this.db.close()}}function q(z){let Q=z?.cwd??process.cwd(),X=Q?U.basename(Q):"unknown-project",$=new M;try{let W=$.getRecentSummaries(X,5);if(W.length===0){console.log(`# Recent Session Context

No previous sessions found for this project yet.`);return}let Y=[];Y.push("# Recent Session Context"),Y.push("");let v=W.length===1?"session":"sessions";Y.push(`Showing last ${W.length} ${v} for **${X}**:`),Y.push("");for(let Z of W){if(Y.push("---"),Y.push(""),Z.request)Y.push(`**Request:** ${Z.request}`);if(Z.completed)Y.push(`**Completed:** ${Z.completed}`);if(Z.learned)Y.push(`**Learned:** ${Z.learned}`);if(Z.next_steps)Y.push(`**Next Steps:** ${Z.next_steps}`);if(Z.files_read)try{let V=JSON.parse(Z.files_read);if(Array.isArray(V)&&V.length>0)Y.push(`**Files Read:** ${V.join(", ")}`)}catch{if(Z.files_read.trim())Y.push(`**Files Read:** ${Z.files_read}`)}if(Z.files_edited)try{let V=JSON.parse(Z.files_edited);if(Array.isArray(V)&&V.length>0)Y.push(`**Files Edited:** ${V.join(", ")}`)}catch{if(Z.files_edited.trim())Y.push(`**Files Edited:** ${Z.files_edited}`)}Y.push(`**Date:** ${Z.created_at.split("T")[0]}`),Y.push("")}console.log(Y.join(`
`))}finally{$.close()}}try{if(process.stdin.isTTY)q();else{let z=await Bun.stdin.text(),Q=z.trim()?JSON.parse(z):void 0;q(Q)}}catch(z){console.error(`[claude-mem context-hook error: ${z.message}]`),process.exit(0)}
