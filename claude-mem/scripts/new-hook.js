#!/usr/bin/env bun
// @bun
import{spawn as b}from"child_process";import L from"path";import{Database as E}from"bun:sqlite";import{join as Z,dirname as w,basename as S}from"path";import{homedir as F}from"os";import{existsSync as j,mkdirSync as f}from"fs";var $=process.env.CLAUDE_MEM_DATA_DIR||Z(F(),".claude-mem"),B=process.env.CLAUDE_CONFIG_DIR||Z(F(),".claude"),R=Z($,"archives"),y=Z($,"logs"),_=Z($,"trash"),k=Z($,"backups"),I=Z($,"chroma"),h=Z($,"settings.json"),G=Z($,"claude-mem.db"),d=Z(B,"settings.json"),D=Z(B,"commands"),m=Z(B,"CLAUDE.md");function x(Q){f(Q,{recursive:!0})}class V{db;constructor(){x($),this.db=new E(G,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(Q,X=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(Q,X)}findActiveSDKSession(Q){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(Q)||null}createSDKSession(Q,X,W){let Y=new Date,z=Y.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(Q,X,W,Y.toISOString(),z),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(Q,X){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(X,Q)}storeObservation(Q,X,W,Y){let z=new Date,K=z.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Q,X,Y,W,z.toISOString(),K)}storeSummary(Q,X,W){let Y=new Date,z=Y.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Q,X,W.request||null,W.investigated||null,W.learned||null,W.completed||null,W.next_steps||null,W.files_read||null,W.files_edited||null,W.notes||null,Y.toISOString(),z)}markSessionCompleted(Q){let X=new Date,W=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),W,Q)}markSessionFailed(Q){let X=new Date,W=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),W,Q)}close(){this.db.close()}}function H(Q,X,W){if(Q==="PreCompact"){if(X)return{continue:!0,suppressOutput:!0};return{continue:!1,stopReason:W.reason||"Pre-compact operation failed",suppressOutput:!0}}if(Q==="SessionStart"){if(X&&W.context)return{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:W.context}};return{continue:!0,suppressOutput:!0}}if(Q==="UserPromptSubmit"||Q==="PostToolUse")return{continue:!0,suppressOutput:!0};if(Q==="Stop")return{continue:!0,suppressOutput:!0};return{continue:X,suppressOutput:!0,...W.reason&&!X?{stopReason:W.reason}:{}}}function v(Q,X,W={}){let Y=H(Q,X,W);return JSON.stringify(Y)}function O(Q){if(!Q)throw new Error("newHook requires input");let{session_id:X,cwd:W,prompt:Y}=Q,z=L.basename(W),K=new V;try{if(K.findActiveSDKSession(X)){console.log(v("UserPromptSubmit",!0));return}let M=K.createSDKSession(X,z,Y),q=process.env.CLAUDE_PLUGIN_ROOT;if(!q)throw new Error("CLAUDE_PLUGIN_ROOT not set");let U=L.join(q,"scripts","hooks","worker.js");b("bun",[U,M.toString()],{detached:!0,stdio:"ignore"}).unref(),console.log(v("UserPromptSubmit",!0))}finally{K.close()}}var N=await Bun.stdin.text();try{let Q=N.trim()?JSON.parse(N):void 0;O(Q)}catch(Q){console.error(`[claude-mem new-hook error: ${Q.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
