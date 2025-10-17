#!/usr/bin/env bun
// @bun
import w from"net";import{Database as H}from"bun:sqlite";import{join as $,dirname as T,basename as l}from"path";import{homedir as x}from"os";import{existsSync as y,mkdirSync as E}from"fs";var z=process.env.CLAUDE_MEM_DATA_DIR||$(x(),".claude-mem"),M=process.env.CLAUDE_CONFIG_DIR||$(x(),".claude"),I=$(z,"archives"),k=$(z,"logs"),_=$(z,"trash"),h=$(z,"backups"),D=$(z,"chroma"),d=$(z,"settings.json"),N=$(z,"claude-mem.db"),m=$(M,"settings.json"),u=$(M,"commands"),c=$(M,"CLAUDE.md");function L(Q){return $(z,`worker-${Q}.sock`)}function U(Q){E(Q,{recursive:!0})}class q{db;constructor(){U(z),this.db=new H(N,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(Q,Y=10){return this.db.query(`
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
    `).get(Q)||null}createSDKSession(Q,Y,X){let Z=new Date,W=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(Q,Y,X,Z.toISOString(),W),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(Q,Y){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Y,Q)}storeObservation(Q,Y,X,Z){let W=new Date,B=W.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Q,Y,Z,X,W.toISOString(),B)}storeSummary(Q,Y,X){let Z=new Date,W=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Q,Y,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,Z.toISOString(),W)}markSessionCompleted(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}markSessionFailed(Q){let Y=new Date,X=Y.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Y.toISOString(),X,Q)}close(){this.db.close()}}function g(Q,Y,X){if(Q==="PreCompact"){if(Y)return{continue:!0,suppressOutput:!0};return{continue:!1,stopReason:X.reason||"Pre-compact operation failed",suppressOutput:!0}}if(Q==="SessionStart"){if(Y&&X.context)return{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:X.context}};return{continue:!0,suppressOutput:!0}}if(Q==="UserPromptSubmit"||Q==="PostToolUse")return{continue:!0,suppressOutput:!0};if(Q==="Stop")return{continue:!0,suppressOutput:!0};return{continue:Y,suppressOutput:!0,...X.reason&&!Y?{stopReason:X.reason}:{}}}function J(Q,Y,X={}){let Z=g(Q,Y,X);return JSON.stringify(Z)}var C=new Set(["TodoWrite","ListMcpResourcesTool"]);function f(Q){if(!Q)throw new Error("saveHook requires input");let{session_id:Y,tool_name:X,tool_input:Z,tool_output:W}=Q;if(C.has(X)){console.log(J("PostToolUse",!0));return}let B=new q,K=B.findActiveSDKSession(Y);if(B.close(),!K){console.log(J("PostToolUse",!0));return}let F=L(K.id),b={type:"observation",tool_name:X,tool_input:JSON.stringify(Z),tool_output:JSON.stringify(W)},V=w.connect(F,()=>{V.write(JSON.stringify(b)+`
`),V.end()}),G=!1,v=()=>{if(G)return;G=!0,console.log(J("PostToolUse",!0))};V.on("close",v),V.on("error",v)}var O=await Bun.stdin.text();try{let Q=O.trim()?JSON.parse(O):void 0;f(Q)}catch(Q){console.error(`[claude-mem save-hook error: ${Q.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
