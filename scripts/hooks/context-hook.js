#!/usr/bin/env bun
// @bun
import E from"path";import{Database as x}from"bun:sqlite";import{join as K,dirname as H,basename as P}from"path";import{homedir as L}from"os";import{existsSync as T,mkdirSync as U}from"fs";var B=process.env.CLAUDE_MEM_DATA_DIR||K(L(),".claude-mem"),J=process.env.CLAUDE_CONFIG_DIR||K(L(),".claude"),l=K(B,"archives"),A=K(B,"logs"),R=K(B,"trash"),j=K(B,"backups"),_=K(B,"chroma"),k=K(B,"settings.json"),N=K(B,"claude-mem.db"),I=K(J,"settings.json"),h=K(J,"commands"),y=K(J,"CLAUDE.md");function O(Q){U(Q,{recursive:!0})}class M{db;constructor(){O(B),this.db=new x(N,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(Q,Y=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(Q,Y)}findActiveSDKSession(Q){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(Q)||null}createSDKSession(Q,Y,X){let z=new Date,W=z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(Q,Y,X,z.toISOString(),W),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(Q,Y){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Y,Q)}storeObservation(Q,Y,X,z){let W=new Date,Z=W.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Q,Y,z,X,W.toISOString(),Z)}storeSummary(Q,Y,X){let z=new Date,W=z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Q,Y,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,z.toISOString(),W)}markSessionCompleted(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}markSessionFailed(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}close(){this.db.close()}}function b(Q,Y,X){if(Q==="PreCompact"){if(Y)return{continue:!0,suppressOutput:!0};return{continue:!1,stopReason:X.reason||"Pre-compact operation failed",suppressOutput:!0}}if(Q==="SessionStart"){if(Y&&X.context)return{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:X.context}};return{continue:!0,suppressOutput:!0}}if(Q==="UserPromptSubmit"||Q==="PostToolUse")return{continue:!0,suppressOutput:!0};if(Q==="Stop")return{continue:!0,suppressOutput:!0};return{continue:Y,suppressOutput:!0,...X.reason&&!Y?{stopReason:X.reason}:{}}}function q(Q,Y,X={}){let z=b(Q,Y,X);return JSON.stringify(z)}function F(Q){let Y=Q?.cwd??process.cwd(),X=Y?E.basename(Y):"unknown-project",z=new M;try{let W=z.getRecentSummaries(X,5);if(W.length===0){let $=q("SessionStart",!0,{context:`# Recent Session Context

No previous sessions found for this project yet.`});console.log($);return}let Z=[];Z.push("# Recent Session Context"),Z.push("");let v=W.length===1?"session":"sessions";Z.push(`Showing last ${W.length} ${v} for **${X}**:`),Z.push("");for(let $ of W){if(Z.push("---"),Z.push(""),$.request)Z.push(`**Request:** ${$.request}`);if($.completed)Z.push(`**Completed:** ${$.completed}`);if($.learned)Z.push(`**Learned:** ${$.learned}`);if($.next_steps)Z.push(`**Next Steps:** ${$.next_steps}`);if($.files_read)try{let V=JSON.parse($.files_read);if(Array.isArray(V)&&V.length>0)Z.push(`**Files Read:** ${V.join(", ")}`)}catch{if($.files_read.trim())Z.push(`**Files Read:** ${$.files_read}`)}if($.files_edited)try{let V=JSON.parse($.files_edited);if(Array.isArray(V)&&V.length>0)Z.push(`**Files Edited:** ${V.join(", ")}`)}catch{if($.files_edited.trim())Z.push(`**Files Edited:** ${$.files_edited}`)}Z.push(`**Date:** ${$.created_at.split("T")[0]}`),Z.push("")}let G=q("SessionStart",!0,{context:Z.join(`
`)});console.log(G)}finally{z.close()}}try{if(process.stdin.isTTY)F();else{let Q=await Bun.stdin.text(),Y=Q.trim()?JSON.parse(Q):void 0;F(Y)}}catch(Q){console.error(`[claude-mem context-hook error: ${Q.message}]`),process.exit(0)}
