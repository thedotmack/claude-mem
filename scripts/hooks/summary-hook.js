#!/usr/bin/env bun
// @bun
import E from"net";import{Database as f}from"bun:sqlite";import{join as $,dirname as w,basename as P}from"path";import{homedir as F}from"os";import{existsSync as T,mkdirSync as U}from"fs";var z=process.env.CLAUDE_MEM_DATA_DIR||$(F(),".claude-mem"),v=process.env.CLAUDE_CONFIG_DIR||$(F(),".claude"),A=$(z,"archives"),j=$(z,"logs"),R=$(z,"trash"),_=$(z,"backups"),y=$(z,"chroma"),I=$(z,"settings.json"),G=$(z,"claude-mem.db"),k=$(v,"settings.json"),h=$(v,"commands"),D=$(v,"CLAUDE.md");function x(Q){return $(z,`worker-${Q}.sock`)}function L(Q){U(Q,{recursive:!0})}class J{db;constructor(){L(z),this.db=new f(G,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(Q,Y=10){return this.db.query(`
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
    `).get(Q)||null}createSDKSession(Q,Y,X){let Z=new Date,K=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(Q,Y,X,Z.toISOString(),K),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(Q,Y){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Y,Q)}storeObservation(Q,Y,X,Z){let K=new Date,B=K.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Q,Y,Z,X,K.toISOString(),B)}storeSummary(Q,Y,X){let Z=new Date,K=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Q,Y,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,Z.toISOString(),K)}markSessionCompleted(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}markSessionFailed(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}close(){this.db.close()}}function b(Q,Y,X){if(Q==="PreCompact"){if(Y)return{continue:!0,suppressOutput:!0};return{continue:!1,stopReason:X.reason||"Pre-compact operation failed",suppressOutput:!0}}if(Q==="SessionStart"){if(Y&&X.context)return{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:X.context}};return{continue:!0,suppressOutput:!0}}if(Q==="UserPromptSubmit"||Q==="PostToolUse")return{continue:!0,suppressOutput:!0};if(Q==="Stop")return{continue:!0,suppressOutput:!0};return{continue:Y,suppressOutput:!0,...X.reason&&!Y?{stopReason:X.reason}:{}}}function M(Q,Y,X={}){let Z=b(Q,Y,X);return JSON.stringify(Z)}function N(Q){if(!Q)throw new Error("summaryHook requires input");let{session_id:Y}=Q,X=new J,Z=X.findActiveSDKSession(Y);if(X.close(),!Z){console.log(M("Stop",!0));return}let K=x(Z.id),B={type:"finalize"},W=E.connect(K,()=>{W.write(JSON.stringify(B)+`
`),W.end()}),V=!1,q=()=>{if(V)return;V=!0,console.log(M("Stop",!0))};W.on("close",q),W.on("error",q)}var O=await Bun.stdin.text();try{let Q=O.trim()?JSON.parse(O):void 0;N(Q)}catch(Q){console.error(`[claude-mem summary-hook error: ${Q.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
